// Minimal SMTP client (node:net/node:tls only): EHLO, STARTTLS or implicit TLS, AUTH LOGIN, one message per call.
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

/** SMTP settings from env; null when email is not configured. */
export function smtpConfig(env = process.env) {
  if (!env.MIZAN_SMTP_HOST || !env.MIZAN_SMTP_FROM) return null;
  return {
    host: env.MIZAN_SMTP_HOST,
    port: Number(env.MIZAN_SMTP_PORT ?? 587),
    secure: env.MIZAN_SMTP_SECURE === '1', // implicit TLS (465); otherwise STARTTLS when offered
    user: env.MIZAN_SMTP_USER,
    pass: env.MIZAN_SMTP_PASS,
    from: env.MIZAN_SMTP_FROM,
    rejectUnauthorized: env.MIZAN_SMTP_INSECURE !== '1',
  };
}

const header = (v) => String(v).replace(/[\r\n]+/g, ' ').slice(0, 900);
const encodeWord = (v) => (/^[\x20-\x7e]*$/.test(v) ? header(v) : `=?UTF-8?B?${Buffer.from(header(v)).toString('base64')}?=`);
const ADDRESS = /^[^@\s<>,;"]{1,64}@[^@\s<>,;"]{1,190}$/;

/** Reads SMTP replies (multi-line aware) from a socket. */
function replies(socket) {
  let buffer = '';
  const waiting = [];
  const ready = [];
  const flush = () => {
    while (waiting.length && ready.length) waiting.shift()(ready.shift());
  };
  // A reply is complete at its "NNN text" line; "NNN-text" lines continue it.
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const lines = [];
      let rest = buffer;
      let code = null;
      let done = false;
      while (!done) {
        const m = /^(\d{3})([ -])(.*)\r?\n/.exec(rest);
        if (!m) break;
        lines.push(m[3]);
        code = Number(m[1]);
        rest = rest.slice(m[0].length);
        done = m[2] === ' ';
      }
      if (!done) return;
      buffer = rest;
      ready.push({ code, text: lines.join('\n') });
      flush();
    }
  };
  socket.on('data', onData);
  return {
    next: () => new Promise((resolve) => { waiting.push(resolve); flush(); }),
    detach: () => socket.off('data', onData),
  };
}

/**
 * Send one plain-text email. Resolves on 250 after DATA; rejects with the server's reply otherwise.
 * @param {{to: string, subject: string, text: string}} msg
 */
export async function sendMail(cfg, { to, subject, text }) {
  if (!ADDRESS.test(to)) throw new Error(`Invalid recipient ${to}`);
  const timeoutMs = 20000;
  let socket = cfg.secure
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized })
    : net.connect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('SMTP timeout')));
  const failed = new Promise((_, reject) => socket.once('error', reject));
  let r = replies(socket);
  const expect = async (codes) => {
    const reply = await Promise.race([r.next(), failed]);
    if (!codes.includes(reply.code)) throw new Error(`SMTP ${reply.code}: ${reply.text}`);
    return reply;
  };
  const cmd = (line, codes) => { socket.write(`${line}\r\n`); return expect(codes); };
  try {
    await expect([220]);
    let ehlo = await cmd('EHLO mizan.local', [250]);
    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      r.detach();
      socket = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      r = replies(socket);
      ehlo = await cmd('EHLO mizan.local', [250]);
    }
    if (cfg.user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(Buffer.from(cfg.user).toString('base64'), [334]);
      await cmd(Buffer.from(cfg.pass ?? '').toString('base64'), [235]);
    }
    await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      `From: ${header(cfg.from)}`, `To: ${header(to)}`, `Subject: ${encodeWord(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@mizan>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body,
    ].join('\r\n');
    await cmd(`${message}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally {
    socket.end();
  }
}
