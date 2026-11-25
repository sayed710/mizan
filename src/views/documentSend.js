import { postNote } from '../orm.js';
import { getUser, isServer } from '../store.js';
import { t } from '../i18n.js';

/** Integrations whose buttons fall back to only recording a send when not configured. */
export const SENDING = { smtp: 'Email', sms: 'SMS' };

/** Where a button/action sends (server endpoint), whether that integration is live, and the unconfigured channel otherwise. */
export function sendTarget(action) {
  const endpoint = action.server ?? (action.email === 'mailing' ? '/api/mail/mailing' : action.email ? '/api/mail/document' : null);
  const need = action.requires ?? (action.email ? 'smtp' : 'server');
  const live = Boolean(endpoint && isServer() && (need === 'server' || getUser()?.integrations?.[need]));
  return { endpoint, live, channel: !live && endpoint && SENDING[need] };
}

/** Whether the action/wizard confirmation requests sending email. */
export function shouldSendEmail(action, spec, values) {
  const hasEmailField = spec?.fields?.some((f) => f.name === 'email');
  return Boolean(action.email && (hasEmailField ? values?.email : true));
}

/** Prompt the user before recording a send when the transport is not configured. */
export function confirmUnconfiguredSend(channel) {
  return confirm(t('{channel} is not configured, so nothing will be sent. Mark it as sent anyway?', { channel: t(channel) }));
}

/** Record an unsent chatter note on `id` when the transport is unconfigured. */
export function postUnsentNote(db, model, id, channel) {
  return postNote(db, model, id, t('Not sent: {channel} is not configured.', { channel: t(channel) }));
}

const STATUS_NOT_RECORDED_PREFIX = 'The email was sent, but its status could not be recorded: ';

/**
 * Classify a document-send failure: delivered emails whose status could not be recorded are
 * non-retryable and formatted with their translated reason.
 */
export function classifySendError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.startsWith(STATUS_NOT_RECORDED_PREFIX)) {
    return {
      retryable: false,
      message: t('The email was sent, but its status could not be recorded: {reason}', {
        reason: t(message.slice(STATUS_NOT_RECORDED_PREFIX.length)),
      }),
    };
  }
  return { retryable: true, message: t(message) };
}
