// Static asset delivery: compression and cache policy for the built client.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { extname } from 'node:path';

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const MIN_BYTES = 1024;
// Hashed build files never change, so their compressed form is computed once per encoding.
const cache = new Map();

/** Preferred encoding the client accepts ('br', 'gzip' or null), ignoring entries with q=0. */
export function acceptedEncoding(header = '') {
  const offered = new Set(String(header).split(',').map((part) => part.trim().split(';')).filter(([, q]) => !/^\s*q=0(\.0*)?\s*$/.test(q ?? '')).map(([name]) => name.trim().toLowerCase()));
  if (offered.has('br')) return 'br';
  if (offered.has('gzip') || offered.has('*')) return 'gzip';
  return null;
}

/** Body to send for a file, compressed when worthwhile; immutable files are cached by path. */
export function encodeBody(file, body, acceptEncoding, immutable) {
  const encoding = COMPRESSIBLE.has(extname(file)) && body.length >= MIN_BYTES ? acceptedEncoding(acceptEncoding) : null;
  if (!encoding) return { body, encoding: null };
  const key = `${encoding}:${file}`;
  if (immutable && cache.has(key)) return { body: cache.get(key), encoding };
  const out = encoding === 'br'
    ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: immutable ? 9 : 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body);
  if (immutable) cache.set(key, out);
  return { body: out, encoding };
}

/** Vite puts content-hashed files under /assets/; everything else (index.html) must be revalidated. */
export const isImmutable = (urlPath) => urlPath.startsWith('/assets/');
export const cacheControl = (urlPath) => (isImmutable(urlPath) ? 'public, max-age=31536000, immutable' : 'no-cache');
