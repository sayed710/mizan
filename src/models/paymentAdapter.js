// Explicit redirect/webhook payment adapters and constant-time HMAC signature verification.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { create, postNote, read, search, write } from '../orm.js';
import { documentCurrency, roundCurrency } from '../money.js';
import { paymentJournal } from './ledger.js';
import { registerPayment, residual } from './accounting.js';
import { postPayment } from './pay.js';
import { today, validDate } from './common.js';

/** Error thrown by webhook signature, payload or settlement validation with an explicit HTTP status and code. */
export class WebhookError extends Error {
  constructor(message, status = 400, code = 'PAYMENT_WEBHOOK_ERROR', { signatureVerified = false } = {}) {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
    this.code = code;
    this.signatureVerified = signatureVerified;
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
     * Expected JSON contract: `{ reference: string, status: string, amount?: number, currency?: string, provider_reference?: string, date?: string }`.
     * Returns explicit `{ paid: boolean, status: string }` without guessing synonyms; rejects missing status with 400.
     * @returns {{ reference: string, paid: boolean, status: string, amount: unknown, currency: string, providerReference: string | null, date: unknown }}
     */
    parseWebhook(parsed) {
      const reference = typeof parsed?.reference === 'string' ? parsed.reference.trim() : '';
      if (!reference) throw new WebhookError('Unknown payment transaction reference', 400, 'MISSING_REFERENCE');
      const status = typeof parsed?.status === 'string' ? parsed.status.trim() : '';
      if (!status) throw new WebhookError('Missing payment status in webhook', 400, 'UNSUPPORTED_STATUS');
      return {
        reference,
        paid: status === 'paid',
        status,
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

/** Resolve the liquidity journal used to settle payments for a payment provider and company. */
export function providerPaymentJournal(db, provider, companyId, journalId = null) {
  return paymentJournal(db, journalId ?? provider?.journal_id ?? null, companyId ?? 1);
}

/** Return true when `provider` resolves a valid payment journal for `companyId`. */
export function canSettleInvoiceProvider(db, provider, companyId) {
  try {
    providerPaymentJournal(db, provider, companyId);
    return true;
  } catch (err) {
    if (err?.constructor !== Error) throw err;
    return false;
  }
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

  try {
    providerPaymentJournal(db, provider, companyId);
  } catch (err) {
    if (err?.constructor !== Error) throw err;
    throw new Error('Selected payment provider does not have a valid payment journal configured', { cause: err });
  }

  const expectedAmount = roundCurrency(due, currency);
  const pending = search(db, 'payment.transaction').filter((t) => t.move_id === move.id && t.state === 'pending');
  const reusable = pending.find(
    (t) => t.provider_id === provider.id
      && t.provider_code === provider.code
      && t.currency_id === currency.id
      && roundCurrency(t.amount, currency) === expectedAmount,
  );
  let nextDb = db;
  for (const stale of pending) {
    if (stale !== reusable) {
      nextDb = write(nextDb, 'payment.transaction', stale.id, { state: 'superseded' });
    }
  }
  if (reusable) {
    const redirectUrl = reusable.redirect_url || adapter.createCheckout({
      db: nextDb,
      move,
      provider,
      transaction: reusable,
      amount: expectedAmount,
      currency: currency.name,
      returnUrl,
      baseUrl,
    }).redirectUrl;
    return {
      db: nextDb,
      transaction: read(nextDb, 'payment.transaction', reusable.id),
      redirectUrl,
    };
  }

  const seq = (nextDb.seq['payment.transaction'] ?? 0) + 1;
  const txReference = (typeof reference === 'string' && reference.trim()) ? reference.trim() : `PAY-${move.id}-${seq}`;
  if (search(nextDb, 'payment.transaction').some((t) => t.reference === txReference)) {
    throw new Error('Payment transaction reference already exists');
  }

  const draftTx = {
    reference: txReference,
    provider_reference: '',
    move_id: move.id,
    provider_id: provider.id,
    provider_code: provider.code,
    amount: expectedAmount,
    currency_id: currency.id,
    state: 'pending',
    redirect_url: '',
    company_id: companyId,
  };
  const { redirectUrl, providerReference } = adapter.createCheckout({
    db: nextDb,
    move,
    provider,
    transaction: draftTx,
    amount: draftTx.amount,
    currency: currency.name,
    returnUrl,
    baseUrl,
  });

  const created = create(nextDb, 'payment.transaction', {
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

  // Signature is now verified; any error raised from here on carries signatureVerified: true.
  try {
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookError('Malformed JSON payment webhook payload', 400, 'MALFORMED_JSON', { signatureVerified: true });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WebhookError('Payment webhook payload must be a JSON object', 400, 'INVALID_PAYLOAD', { signatureVerified: true });
    }

    const webhook = adapter.parseWebhook(parsed);
    const tx = search(db, 'payment.transaction').find((t) => t.reference === webhook.reference) ?? null;
    if (!webhook.paid) {
      return {
        db,
        transaction: tx,
        reference: webhook.reference,
        alreadyProcessed: false,
        ignored: true,
        status: 'ignored',
        providerStatus: webhook.status,
        reason: `Payment notification ignored: provider status is '${webhook.status}', not 'paid'`,
      };
    }

    if (!tx) throw new WebhookError('Unknown payment transaction reference', 400, 'UNKNOWN_REFERENCE', { signatureVerified: true });
    if (tx.provider_code !== providerCode) throw new WebhookError('Payment provider mismatch for transaction', 400, 'PROVIDER_MISMATCH', { signatureVerified: true });

    if (tx.state === 'done') {
      return { db, transaction: tx, alreadyProcessed: true, status: 'idempotent' };
    }
    if (tx.state !== 'pending' && tx.state !== 'superseded') {
      throw new WebhookError('Payment transaction is not awaiting settlement', 400, 'INVALID_TRANSACTION_STATE', { signatureVerified: true });
    }

    const move = read(db, 'account.move', tx.move_id);
    if (!move || move.active === false) throw new WebhookError('Invoice not found for payment transaction', 400, 'INVOICE_NOT_FOUND', { signatureVerified: true });
    if (move.state !== 'posted' || move.move_type !== 'out_invoice') {
      throw new WebhookError('Invoice is not in a payable posted state', 400, 'INVOICE_NOT_PAYABLE', { signatureVerified: true });
    }

    const docCurrency = documentCurrency(db, move);
    const txCurrency = read(db, 'res.currency', tx.currency_id) ?? docCurrency;
    if (!docCurrency || !txCurrency || !webhook.currency || webhook.currency !== docCurrency.name || webhook.currency !== txCurrency.name) {
      throw new WebhookError('Payment currency does not match the invoice currency', 400, 'CURRENCY_MISMATCH', { signatureVerified: true });
    }

    const due = residual(move, db);
    const payloadAmount = Number(webhook.amount);
    const expectedAmount = roundCurrency(tx.amount, docCurrency);
    if (!Number.isFinite(payloadAmount) || !(expectedAmount > 0) || roundCurrency(payloadAmount, docCurrency) !== expectedAmount) {
      throw new WebhookError('Payment amount does not match the transaction amount', 400, 'AMOUNT_MISMATCH', { signatureVerified: true });
    }

    const paymentDate = date ?? (validDate(webhook.date) ? webhook.date : today());
    const provider = read(db, 'payment.provider', tx.provider_id);
    const resolvedJournal = providerPaymentJournal(db, provider, move.company_id ?? 1, journalId);
    let settledDb;
    let createdPayment;
    if (due > 0) {
      const priorPaymentIds = new Set((db.records['account.payment'] ?? []).map((p) => p.id));
      settledDb = registerPayment(db, move, { amount: expectedAmount, date: paymentDate, journal_id: resolvedJournal.id }).db;
      createdPayment = (settledDb.records['account.payment'] ?? []).find(
        (p) => !priorPaymentIds.has(p.id) && p.state === 'posted' && (p.company_id ?? 1) === (move.company_id ?? 1),
      );
    } else {
      // Invoice already settled: book an unallocated customer credit without auto-allocating to unrelated invoices.
      const draft = create(db, 'account.payment', {
        partner_id: move.partner_id,
        partner_type: 'customer',
        payment_type: 'inbound',
        amount: expectedAmount,
        currency_id: docCurrency.id,
        date: paymentDate,
        journal_id: resolvedJournal.id,
        company_id: move.company_id ?? 1,
        memo: `${move.name} (${tx.reference})`,
      });
      settledDb = postPayment(draft.db, read(draft.db, 'account.payment', draft.id));
      const posted = read(settledDb, 'account.payment', draft.id);
      if (posted?.state === 'posted') createdPayment = posted;
    }
    if (!createdPayment) {
      throw new WebhookError('Failed to record posted payment for transaction', 500, 'PAYMENT_NOT_CREATED', { signatureVerified: true });
    }

    const updatedTx = write(settledDb, 'payment.transaction', tx.id, {
      state: 'done',
      payment_id: createdPayment.id,
      provider_reference: webhook.providerReference ?? (tx.provider_reference || tx.reference),
    });
    const wasSuperseded = tx.state === 'superseded';
    const overpaid = due < expectedAmount;
    const noteBody = overpaid
      ? `Online payment of ${expectedAmount} ${docCurrency.name} via ${tx.provider_code} (${tx.reference}) ${wasSuperseded ? 'arrived on a superseded checkout ' : 'arrived '}for an amount above the open balance (${due} ${docCurrency.name}); the excess stays as unapplied customer credit.`
      : (wasSuperseded
        ? `Online payment via ${tx.provider_code} (${tx.reference}) arrived on a superseded checkout and was settled.`
        : `Online payment settled via ${tx.provider_code} (${tx.reference}).`);
    const noted = postNote(updatedTx, 'account.move', move.id, noteBody);
    return {
      db: noted,
      transaction: read(noted, 'payment.transaction', tx.id),
      alreadyProcessed: false,
      status: overpaid ? 'unapplied_credit' : 'settled',
    };
  } catch (err) {
    if (err && typeof err === 'object') err.signatureVerified = true;
    throw err;
  }
}
