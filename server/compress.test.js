import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { acceptedEncoding, cacheControl, encodeBody } from './compress.js';

test('picks brotli, then gzip, and honours q=0', () => {
  assert.equal(acceptedEncoding('gzip, deflate, br'), 'br');
  assert.equal(acceptedEncoding('gzip;q=1.0, br;q=0'), 'gzip');
  assert.equal(acceptedEncoding('identity'), null);
  assert.equal(acceptedEncoding(undefined), null);
});

test('compresses text assets and round-trips them', () => {
  const body = Buffer.from('const x = 1;\n'.repeat(500));
  const br = encodeBody('/d/assets/a.js', body, 'br', true);
  assert.equal(br.encoding, 'br');
  assert.ok(br.body.length < body.length / 10);
  assert.deepEqual(brotliDecompressSync(br.body), body);
  assert.equal(encodeBody('/d/assets/a.js', body, 'br', true).body, br.body, 'immutable result is cached');
  assert.deepEqual(gunzipSync(encodeBody('/d/index.html', body, 'gzip', false).body), body);
});

test('leaves small, binary or unaccepted bodies alone', () => {
  const big = Buffer.alloc(5000, 1);
  assert.equal(encodeBody('/d/a.js', Buffer.from('x'), 'br', false).encoding, null);
  assert.equal(encodeBody('/d/a.png', big, 'br', false).encoding, null);
  assert.equal(encodeBody('/d/a.js', big, '', false).encoding, null);
});

test('hashed assets are cached for a year, the shell is revalidated', () => {
  assert.match(cacheControl('/assets/index-abc.js'), /immutable/);
  assert.equal(cacheControl('/index.html'), 'no-cache');
});
