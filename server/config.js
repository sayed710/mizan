// Every environment variable the server reads, in one place (ARCH-009). checkConfig() runs at boot and refuses
// malformed values; docs/CONFIGURATION.md documents the same list (config.test.js keeps the three in step).

/** kind: port | flag (0/1) | url (http/https) | int | path | text | secret */
export const CONFIG = [
  { name: 'PORT', kind: 'port', default: '8069', about: 'HTTP port (0 picks a free port).' },
  { name: 'NODE_ENV', kind: 'text', about: '`production` turns off demo-only features.' },
  { name: 'MIZAN_DB', kind: 'path', default: 'mizan.sqlite', about: 'SQLite database file.' },
  { name: 'MIZAN_ADMIN_PASSWORD', kind: 'secret', about: 'Password of the `admin` user created on first start (otherwise a random one is generated).' },
  { name: 'MIZAN_SECURE_COOKIE', kind: 'flag', about: 'Session cookies get `Secure`: on by default when `NODE_ENV=production`; `0` for plain-HTTP LAN use, `1` to force.' },
  { name: 'MIZAN_TRUST_PROXY', kind: 'flag', about: '`1` behind a reverse proxy: the client IP is read from `X-Forwarded-For`.' },
  { name: 'MIZAN_PUBLIC_URL', kind: 'url', about: 'Public origin of the site (links in emails, sitemap, Twilio signatures).' },
  { name: 'MIZAN_LOG_REQUESTS', kind: 'flag', default: '1', about: '`0` turns off the per-request JSON access log.' },
  { name: 'MIZAN_DEMO_PAYMENTS', kind: 'flag', about: '`1` lets the shop confirm orders without a payment (ignored in production).' },
  { name: 'MIZAN_SMTP_HOST', kind: 'text', about: 'SMTP server; email is sent only when set.' },
  { name: 'MIZAN_SMTP_PORT', kind: 'port', default: '587', about: 'SMTP port.' },
  { name: 'MIZAN_SMTP_USER', kind: 'text', about: 'SMTP user.' },
  { name: 'MIZAN_SMTP_PASS', kind: 'secret', about: 'SMTP password.' },
  { name: 'MIZAN_SMTP_FROM', kind: 'text', about: 'Sender address.' },
  { name: 'MIZAN_SMTP_SECURE', kind: 'flag', about: '`1` for implicit TLS (port 465); otherwise STARTTLS when offered.' },
  { name: 'MIZAN_SMTP_INSECURE', kind: 'flag', about: '`1` accepts an invalid SMTP certificate (testing only).' },
  { name: 'MIZAN_AI', kind: 'flag', about: '`1` turns on AI features with the default Anthropic credentials.' },
  { name: 'ANTHROPIC_API_KEY', kind: 'secret', about: 'Anthropic API key for AI features.' },
  { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', about: 'Alternative Anthropic credential.' },
  { name: 'MIZAN_WHATSAPP_TOKEN', kind: 'secret', about: 'WhatsApp Cloud API token.' },
  { name: 'MIZAN_WHATSAPP_PHONE_ID', kind: 'text', about: 'WhatsApp sender phone number id.' },
  { name: 'MIZAN_WHATSAPP_APP_SECRET', kind: 'secret', about: 'Meta app secret used to verify webhook signatures.' },
  { name: 'MIZAN_WHATSAPP_VERIFY_TOKEN', kind: 'secret', about: 'Token Meta sends when the webhook is registered.' },
  { name: 'MIZAN_TWILIO_SID', kind: 'text', about: 'Twilio account SID for SMS.' },
  { name: 'MIZAN_TWILIO_TOKEN', kind: 'secret', about: 'Twilio auth token (also verifies inbound SMS).' },
  { name: 'MIZAN_TWILIO_FROM', kind: 'text', about: 'Twilio sender number.' },
  { name: 'MIZAN_SHIPPING_TOKEN', kind: 'secret', about: 'Token for carrier rate APIs.' },
  { name: 'MIZAN_MARKETPLACE_TOKEN', kind: 'secret', about: 'Token for marketplace order feeds.' },
];

const valid = {
  port: (v) => /^\d+$/.test(v) && Number(v) <= 65535,
  flag: (v) => v === '0' || v === '1',
  url: (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } },
  int: (v) => /^\d+$/.test(v),
  path: (v) => v.trim() !== '',
  text: () => true,
  secret: () => true,
};
const expected = { port: 'a port number (0-65535)', flag: '0 or 1', url: 'an http(s) URL', int: 'a whole number', path: 'a file path' };

/** Problems with the configured values, as readable lines (empty = fine). Unset variables are never a problem. */
export function checkConfig(env = process.env) {
  return CONFIG.filter(({ name, kind }) => env[name] !== undefined && env[name] !== '' && !valid[kind](env[name]))
    .map(({ name, kind }) => `${name} must be ${expected[kind]}`);
}
