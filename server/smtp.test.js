import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail } from './smtp.js';

/** Tiny fake SMTP server that records the conversation. */
function fakeServer() {
  const seen = [];
  const server = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n');
    let inData = false;
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; s.write('250 queued\r\n'); } else seen.push(`DATA:${line}`);
          continue;
        }
        seen.push(line);
        if (line.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (line === Buffer.from('user').toString('base64')) s.write('334 UGFzc3dvcmQ6\r\n');
        else if (line === Buffer.from('secret').toString('base64')) s.write('235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT')) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); } else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('sends an authenticated UTF-8 message and dot-stuffs the body', async () => {
  const { server, seen, port } = await fakeServer();
  await sendMail({ host: '127.0.0.1', port, user: 'user', pass: 'secret', from: 'erp@mizan.example' }, { to: 'client@example.com', subject: 'فاتورة INV/2026/00001', text: 'Hello\n.hidden line' });
  server.close();
  assert.ok(seen.includes('MAIL FROM:<erp@mizan.example>'));
  assert.ok(seen.includes('RCPT TO:<client@example.com>'));
  assert.ok(seen.some((l) => l.startsWith('DATA:Subject: =?UTF-8?B?')));
  assert.ok(seen.includes('DATA:..hidden line'));
});

test('rejects header injection in the recipient', async () => {
  await assert.rejects(sendMail({ host: '127.0.0.1', port: 1, from: 'a@b.c' }, { to: 'x@y.z\r\nBcc: evil@e.com', subject: 's', text: 't' }), /Invalid recipient/);
});
