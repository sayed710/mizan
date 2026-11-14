// Single outbound mail-transport hook for server-side follow-up reminders.
import { sendMail, smtpConfig } from './smtp.js';

/**
 * Create the mail-transport hook used by `runFollowUps`.
 * Delivery contract:
 * - Resolves to `{ status: 'sent' }` when handed off to SMTP.
 * - Resolves to `{ status: 'outbox_only', reason }` when SMTP is unconfigured (`!smtp`), keeping the reminder unsent.
 * - Rejects/throws on transport failure.
 */
export function createMailTransport({ smtp = null, send = sendMail, env = process.env } = {}) {
  const config = smtp ?? smtpConfig(env);
  return async (message) => {
    if (!config) {
      return {
        status: 'outbox_only',
        reason: 'Outbox only: automatic email transport is not configured.',
      };
    }
    await send(config, message);
    return { status: 'sent' };
  };
}
