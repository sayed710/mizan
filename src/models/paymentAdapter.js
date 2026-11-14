// Explicit redirect/webhook payment adapters and constant-time HMAC signature verification.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { create, postNote, read, search, write } from '../orm.js';
import { documentCurrency, roundCurrency } from '../money.js';
import { paymentJournal } from './ledger.js';
import { registerPayment, residual } from './accounting.js';
import { today, validDate } from './common.js';

/** Error thrown by webhook signature, payload or settlement validation with an explicit HTTP status and code. */
export class WebhookError extends Error {
  constructor(message, status = 400, code = 'PAYMENT_WEBHOOK_ERROR') {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
    this.code = code;
  }
}

/** Registered online payment provider adapters keyed explicitly by `payment.provider.code`. */
export const PAYMENT_ADAPTERS = {
  demo: {
    code: 'demo',
    createCheckout({ move, transaction, amount, currency, returnUrl = '', baseUrl = '' }) {
      const origin = baseUrl ? String(baseUrl).replace(/\/+$/, '') : '';
      const q = new URLSearchParams({
        reference: transaction.reference,
        amount: String(amount),
        currency,
        ...(returnUrl ? { return_url: returnUrl } : {}),
      });
      return {
        redirectUrl: `${origin}/my/invoices/${move.id}/pay/demo?${q.toString()}`,
        providerReference: transaction.reference,
      };
    },
    /**
     * Parse and validate a verified demo provider webhook payload.
     * Expected JSON contract: `{ reference: string, status: 'paid', amount: number, currency: string, provider_reference?: string, date?: string }`.
     * Rejects missing or non-'paid' status values without guessing synonyms.
     * @returns {{ reference: string, paid: boolean, amount: unknown, currency: string, providerReference: string | null, date: unknown }}
     */
    parseWebhook(parsed) {
      const reference = typeof parsed?.reference === 'string' ? parsed.reference.trim() : '';
      if (!reference) throw new WebhookError('Unknown payment transaction reference', 400, 'MISSING_REFERENCE');
      const status = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
      if (status !== 'paid') throw new WebhookError('Unsupported payment status in webhook', 400, 'UNSUPPORTED_STATUS');
      return {
        reference,
        paid: true,
        amount: parsed.amount,
        currency: typeof parsed.currency === 'string' ? parsed.currency.trim().toUpperCase() : '',
        providerReference: typeof parsed.provider_reference === 'string' && parsed.provider_reference.trim()
          ? parsed.provider_reference.trim()
          : null,
        date: parsed.date ?? null,
      };
    },
  },
};

/** Require a non-empty webhook secret; fails closed and never logs or substitutes a fallback. */
export function requireWebhookSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new WebhookError('Payment webhook secret is not configured', 503, 'WEBHOOK_SECRET_NOT_CONFIGURED');
  }
  return secret;
}

/** Sign a raw webhook payload string using HMAC-SHA256 hex digest. */
export function signWebhookPayload(rawBody, secret) {
  const key = requireWebhookSecret(secret);
  const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? {});
  return createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

/** Verify a raw webhook body string HMAC-SHA256 signature in constant time without revealing length mismatches. */
export function verifyWebhookSignature(rawBody, signature, secret) {
  const key = requireWebhookSecret(secret);
  if (typeof rawBody !== 'string' || typeof signature !== 'string' || !signature) return false;
  const normalized = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) return false;
  const expected = Buffer.from(signWebhookPayload(rawBody, key), 'hex');
  const provided = Buffer.from(normalized.toLowerCase(), 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Create a checkout session and pending `payment.transaction` for a posted, unpaid customer invoice.
 * Returns `{ db, transaction, redirectUrl }` immutably.
 */
export function createInvoiceCheckout(db, moveId, providerId, { baseUrl = '', returnUrl = '', reference = null } = {}) {
  const move = read(db, 'account.move', Number(moveId));
  if (!move || move.active === false) throw new Error('Invoice not found');
  if (move.move_type !== 'out_invoice') throw new Error('Online payment checkout is only supported for customer invoices');
  if (move.state !== 'posted') throw new Error('Invoice must be posted before creating a payment checkout');
  const due = residual(move, db);
  if (!(due > 0)) throw new Error('Invoice is already paid');

  const provider = read(db, 'payment.provider', Number(providerId));
  if (!provider) throw new Error('Payment provider not found');
  if (provider.state !== 'enabled') throw new Error('Selected payment provider is not enabled');
  const companyId = move.company_id ?? 1;
  if (provider.company_id && provider.company_id !== companyId) throw new Error('Payment provider belongs to another company');

  const adapter = PAYMENT_ADAPTERS[provider.code];
  if (!adapter) throw new Error('Selected payment provider does not support online checkout redirects');

  const currency = documentCurrency(db, move);
  if (!currency) throw new Error('Configure a currency on the invoice before starting online payment');

  const seq = (db.seq['payment.transaction'] ?? 0) + 1;
  const txReference = (typeof reference === 'string' && reference.trim()) ? reference.trim() : `PAY-${move.id}-${seq}`;
  if (search(db, 'payment.transaction').some((t) => t.reference === txReference)) {
    throw new Error('Payment transaction reference already exists');
  }

  const draftTx = {
    reference: txReference,
    provider_reference: '',
    move_id: move.id,
    provider_id: provider.id,
    provider_code: provider.code,
    amount: roundCurrency(due, currency),
    currency_id: currency.id,
    state: 'pending',
    redirect_url: '',
    company_id: companyId,
  };
  const { redirectUrl, providerReference } = adapter.createCheckout({
    db,
    move,
    provider,
    transaction: draftTx,
    amount: draftTx.amount,
    currency: currency.name,
    returnUrl,
    baseUrl,
  });

  const created = create(db, 'payment.transaction', {
    ...draftTx,
    provider_reference: providerReference ?? txReference,
    redirect_url: redirectUrl,
  });
  return {
    db: created.db,
    transaction: read(created.db, 'payment.transaction', created.id),
    redirectUrl,
  };
}

/**
 * Validate a signed raw webhook body string and settle the matching invoice once through `registerPayment`.
 * Replays of an already-settled transaction return `{ db, transaction, alreadyProcessed: true }` as a no-op.
 * All validation errors throw `WebhookError` without mutating `db`.
 */
export function processPaymentWebhook(db, { providerCode = null, rawBody = null, signature = '', secret = '', date = null, journalId = null } = {}) {
  const adapter = providerCode ? PAYMENT_ADAPTERS[providerCode] : null;
  if (!adapter || typeof adapter.parseWebhook !== 'function') {
    throw new WebhookError('Unknown payment provider', 404, 'UNKNOWN_PROVIDER');
  }
  const key = requireWebhookSecret(secret);
  if (typeof rawBody !== 'string') {
    throw new WebhookError('Webhook raw body string is required', 400, 'RAW_BODY_REQUIRED');
  }
  if (!verifyWebhookSignature(rawBody, signature, key)) {
    throw new WebhookError('Invalid payment webhook signature', 401, 'INVALID_SIGNATURE');
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookError('Malformed JSON payment webhook payload', 400, 'MALFORMED_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookError('Payment webhook payload must be a JSON object', 400, 'INVALID_PAYLOAD');
  }

  const webhook = adapter.parseWebhook(parsed);
  if (!webhook.paid) {
    throw new WebhookError('Unsupported payment status in webhook', 400, 'UNSUPPORTED_STATUS');
  }

  const tx = search(db, 'payment.transaction').find((t) => t.reference === webhook.reference);
  if (!tx) throw new WebhookError('Unknown payment transaction reference', 400, 'UNKNOWN_REFERENCE');
  if (tx.provider_code !== providerCode) throw new WebhookError('Payment provider mismatch for transaction', 400, 'PROVIDER_MISMATCH');

  if (tx.state === 'done') {
    return { db, transaction: tx, alreadyProcessed: true, status: 'idempotent' };
  }
  if (tx.state === 'cancel' || tx.state === 'error') {
    throw new WebhookError('Payment transaction is not awaiting settlement', 400, 'INVALID_TRANSACTION_STATE');
  }

  const move = read(db, 'account.move', tx.move_id);
  if (!move || move.active === false) throw new WebhookError('Invoice not found for payment transaction', 400, 'INVOICE_NOT_FOUND');
  if (move.state !== 'posted' || move.move_type !== 'out_invoice') {
    throw new WebhookError('Invoice is not in a payable posted state', 400, 'INVOICE_NOT_PAYABLE');
  }

  const docCurrency = documentCurrency(db, move);
  const txCurrency = read(db, 'res.currency', tx.currency_id) ?? docCurrency;
  if (!docCurrency || !txCurrency || !webhook.currency || webhook.currency !== docCurrency.name || webhook.currency !== txCurrency.name) {
    throw new WebhookError('Payment currency does not match the invoice currency', 400, 'CURRENCY_MISMATCH');
  }

  const due = residual(move, db);
  if (!(due > 0)) throw new WebhookError('Invoice is already paid', 400, 'ALREADY_PAID');

  const payloadAmount = Number(webhook.amount);
  const expectedAmount = roundCurrency(tx.amount, docCurrency);
  if (!Number.isFinite(payloadAmount) || roundCurrency(payloadAmount, docCurrency) !== expectedAmount || expectedAmount !== due) {
    throw new WebhookError('Payment amount does not match the invoice amount due', 400, 'AMOUNT_MISMATCH');
  }

  const paymentDate = date ?? (validDate(webhook.date) ? webhook.date : today());
  const provider = read(db, 'payment.provider', tx.provider_id);
  const resolvedJournal = paymentJournal(db, journalId ?? provider?.journal_id ?? null, move.company_id ?? 1);
  const priorPaymentIds = new Set((db.records['account.payment'] ?? []).map((p) => p.id));
  const registered = registerPayment(db, move, { amount: expectedAmount, date: paymentDate, journal_id: resolvedJournal.id });
  const createdPayment = (registered.db.records['account.payment'] ?? []).find(
    (p) => !priorPaymentIds.has(p.id) && p.state === 'posted' && (p.company_id ?? 1) === (move.company_id ?? 1),
  );
  if (!createdPayment) {
    throw new WebhookError('Failed to record posted payment for transaction', 500, 'PAYMENT_NOT_CREATED');
  }

  const updatedTx = write(registered.db, 'payment.transaction', tx.id, {
    state: 'done',
    payment_id: createdPayment.id,
    provider_reference: webhook.providerReference ?? (tx.provider_reference || tx.reference),
  });
  const noted = postNote(
    updatedTx,
    'account.move',
    move.id,
    `Online payment settled via ${tx.provider_code} (${tx.reference}).`,
  );
  return {
    db: noted,
    transaction: read(noted, 'payment.transaction', tx.id),
    alreadyProcessed: false,
    status: 'settled',
  };
}
