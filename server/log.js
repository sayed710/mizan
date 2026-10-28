// Structured logging (ARCH-009): one JSON object per line, errors to stderr, everything else to stdout.

/** Writes `{time, level, msg, ...fields}`. Errors in fields are reduced to their message and stack. */
export function log(level, msg, fields = {}) {
  const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? { message: v.message, stack: v.stack } : v]));
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...clean });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

/** `path` with token-like segments (16+ URL-safe characters: share, sign, tracking links) masked for the access log. */
export const redactPath = (path) => path.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:token');
