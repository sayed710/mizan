import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { create, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { sendDocument, sendMailing } from './mail.js';

/** Minimal SMTP server accepting every message; resolves with what it received. */
function fakeSmtp() {
  const seen = [];
  const server = net.createServer((s) => {
    s.write('220 fake\r\n');
    let inData = false;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else seen.push(line); continue; }
        seen.push(line);
        if (line.startsWith('EHLO')) s.write('250 fake\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, cfg: { host: '127.0.0.1', port: server.address().port, from: 'erp@mizan.example' } })));
}

const admin = { name: 'Admin', isAdmin: true };

test('documents that cannot be emailed, missing records and partners without email are refused', async () => {
  const db = seed();
  assert.equal((await sendDocument({}, db, admin, { model: 'crm.lead', id: 1 })).status, 400);
  assert.equal((await sendDocument({}, db, admin, { model: 'sale.order', id: 99999 })).status, 404);
  const partner = create(db, 'res.partner', { name: 'No Mail' });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [] });
  const out = await sendDocument({}, order.db, admin, { model: 'sale.order', id: order.id });
  assert.deepEqual([out.status, out.body.error], [400, 'The customer has no email address']);
});

test('a draft quotation is emailed to its customer, marked sent and noted in the chatter', async () => {
  const { server, seen, cfg } = await fakeSmtp();
  const base = seed();
  const partner = create(base, 'res.partner', { name: 'Mail Client', email: 'client@example.com' });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [{ product_id: 1, qty: 2, price_unit: 50, tax: 0 }] });
  const out = await sendDocument(cfg, order.db, admin, { model: 'sale.order', id: order.id });
  server.close();
  assert.equal(out.status, 200);
  assert.ok(seen.includes('RCPT TO:<client@example.com>'));
  assert.ok(seen.some((l) => l.includes('Total:')));
  assert.equal(read(out.db, 'sale.order', order.id).state, 'sent');
  assert.ok(out.db.messages.some((m) => m.res_id === order.id && /Sent by email to client@example.com/.test(m.body)));
});

test('a mailing that does not exist or was already sent is refused', async () => {
  const db = seed();
  const store = { get: () => db, commit: () => assert.fail('nothing to commit') };
  assert.equal((await sendMailing({}, store, { id: 99999 }, 'https://erp.example')).status, 404);
  const { db: withMailing, id } = create(db, 'mailing.mailing', { subject: 'Hi', list_id: search(db, 'mailing.list')[0].id, body: 'Hello' });
  const sent = write(withMailing, 'mailing.mailing', id, { state: 'sent' });
  const out = await sendMailing({}, { get: () => sent, commit: () => {} }, { id }, 'https://erp.example');
  assert.deepEqual([out.status, out.body.error], [400, 'Already sent']);
});
