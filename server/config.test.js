import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CONFIG, checkConfig } from './config.js';

test('malformed values are refused, unset and well-formed ones pass', () => {
  assert.deepEqual(checkConfig({}), []);
  assert.deepEqual(checkConfig({ PORT: '8069', MIZAN_SECURE_COOKIE: '1', MIZAN_PUBLIC_URL: 'https://erp.example', MIZAN_SMTP_PORT: '' }), []);
  assert.deepEqual(checkConfig({ PORT: 'eighty', MIZAN_TRUST_PROXY: 'yes', MIZAN_PUBLIC_URL: 'erp.example', MIZAN_SMTP_PORT: '70000' }), [
    'PORT must be a port number (0-65535)',
    'MIZAN_PUBLIC_URL must be an http(s) URL',
    'MIZAN_SMTP_PORT must be a port number (0-65535)',
    'MIZAN_TRUST_PROXY must be 0 or 1',
  ].sort((a, b) => CONFIG.findIndex((c) => a.startsWith(c.name + ' ')) - CONFIG.findIndex((c) => b.startsWith(c.name + ' '))));
});

test('every environment variable the server reads is declared and documented', () => {
  const dir = new URL('.', import.meta.url);
  const used = new Set(readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .flatMap((f) => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])));
  const declared = new Set(CONFIG.map((c) => c.name));
  assert.deepEqual([...used].filter((name) => !declared.has(name)), []);
  const docs = readFileSync(new URL('../docs/CONFIGURATION.md', import.meta.url), 'utf8');
  assert.deepEqual([...declared].filter((name) => !docs.includes(`\`${name}\``)), []);
});

test('the access log masks token-like path segments', async () => {
  const { redactPath } = await import('./log.js');
  assert.equal(redactPath('/share/Xk3_9fLq2Vb7Tz1Rw8Yp/12'), '/share/:token/12');
  assert.equal(redactPath('/api/public/sms/inbound'), '/api/public/sms/inbound');
  assert.equal(redactPath('/m/o/0123456789abcdef0123'), '/m/o/:token');
});
