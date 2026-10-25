// WhatsApp Cloud API webhook: Meta's subscription check (GET) and signed event deliveries (POST).
//   MIZAN_WHATSAPP_VERIFY_TOKEN  token typed in the Meta app's webhook settings
//   MIZAN_WHATSAPP_APP_SECRET    app secret used to sign deliveries (X-Hub-Signature-256)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { applyStatus, receiveMessage } from '../src/models/whatsapp.js';

export const MAX_WEBHOOK_BODY = 256 * 1024;
/** applyDiff options for webhook writes: WhatsApp models only, as a non-admin author. */
export const WEBHOOK_WRITE = { author: 'WhatsApp', isAdmin: false, allowed: new Set(['whatsapp.message', 'whatsapp.template']) };

/** Constant-time string comparison (hashed first so lengths always match). */
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

/** Meta's verification request: echo hub.challenge for the right token, else 403. */
export function verifyWebhook(env, params) {
  const token = env.MIZAN_WHATSAPP_VERIFY_TOKEN;
  const ok = !!token && params.get('hub.mode') === 'subscribe' && sameSecret(params.get('hub.verify_token') ?? '', token);
  return ok ? { status: 200, body: String(params.get('hub.challenge') ?? '') } : { status: 403, body: 'Forbidden' };
}

/** True when `header` is "sha256=<hex HMAC-SHA256 of raw with the app secret>". */
export function checkSignature(env, raw, header) {
  const secret = env.MIZAN_WHATSAPP_APP_SECRET;
  const given = /^sha256=([0-9a-f]{64})$/i.exec(String(header ?? ''))?.[1];
  if (!secret || !given) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

/** Request body as a Buffer, rejected beyond `max` bytes. */
export function readRaw(req, max = MAX_WEBHOOK_BODY) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { fail(new Error('Request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

const textOf = (m) => m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `[${String(m.type ?? 'message')}]`;

/** Signed delivery: incoming messages and status updates applied to `db`. @returns {{status: number, body: object, db?: object}} */
export function handleWebhook(env, db, raw, signature) {
  if (!checkSignature(env, raw, signature)) return { status: 401, body: { error: 'Invalid signature' } };
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
  const values = (Array.isArray(payload?.entry) ? payload.entry : []).flatMap((e) => (Array.isArray(e?.changes) ? e.changes : []).map((c) => c?.value ?? {}));
  let next = db;
  for (const value of values) {
    for (const m of Array.isArray(value.messages) ? value.messages : []) {
      next = receiveMessage(next, { from: m.from, text: textOf(m), id: m.id, timestamp: m.timestamp });
    }
    for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
      const err = s.errors?.[0];
      next = applyStatus(next, s.id, s.status, { error: err ? String(err.title ?? err.message ?? err.code) : '' });
    }
  }
  return { status: 200, body: { ok: true }, db: next };
}
