// HTTP webhook endpoint for signed online payment provider notifications.
import { PAYMENT_ADAPTERS, processPaymentWebhook } from '../src/models/paymentAdapter.js';

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
};

/**
 * Verify a signed provider webhook in constant time and register the invoice payment once.
 * Never logs the configured secret or raw signature header.
 */
export async function handlePaymentWebhook({
  req,
  res,
  providerCode,
  getDb,
  commitDb,
  readRaw,
  env = process.env,
  log = () => {},
  maxBody = 65536,
  onRejected = () => {},
}) {
  const reject = (status, error) => {
    onRejected();
    return sendJson(res, status, { error });
  };

  if (req.method !== 'POST') return reject(405, 'Method not allowed');
  if (!providerCode || !PAYMENT_ADAPTERS[providerCode]) {
    req.resume?.();
    log('warn', 'payment webhook rejected', { providerCode, status: 404, code: 'UNKNOWN_PROVIDER' });
    return reject(404, 'Unknown payment provider');
  }
  const secret = env.MIZAN_PAYMENT_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !secret.trim()) {
    log('error', 'payment webhook rejected: secret is not configured', { providerCode });
    return reject(503, 'Payment webhook secret is not configured');
  }
  if (Number(req.headers['content-length']) > maxBody) {
    req.resume?.();
    return reject(413, 'Webhook payload too large');
  }
  let raw;
  try {
    raw = await readRaw(req, maxBody);
  } catch (e) {
    const tooLarge = e?.status === 413 || e?.message === 'Request too large';
    const status = tooLarge ? 413 : 400;
    const msg = tooLarge ? 'Webhook payload too large' : 'Failed to read webhook request body';
    log('warn', 'payment webhook body read failed', { providerCode, status, reason: e?.message ?? msg });
    return reject(status, msg);
  }
  const rawBody = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  const signature = String(req.headers['x-mizan-signature'] ?? '');
  try {
    const out = processPaymentWebhook(getDb(), {
      providerCode,
      rawBody,
      signature,
      secret,
    });
    if (!out.alreadyProcessed && out.db) {
      commitDb(out.db, { actor: `webhook:${providerCode}` });
    }
    return sendJson(res, 200, {
      ok: true,
      alreadyProcessed: out.alreadyProcessed,
      status: out.status,
      reference: out.transaction.reference,
    });
  } catch (e) {
    const msg = e?.message ?? 'Invalid payment webhook';
    const status = Number.isInteger(e?.status) ? e.status : 400;
    log('warn', 'payment webhook rejected', { providerCode, status, code: e?.code, reason: msg });
    return reject(status, msg);
  }
}
