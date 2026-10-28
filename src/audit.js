// Server-side change log: what changed between two database versions, record by record.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const SECRET_KEY = /token|secret|password|passwd|api_?key|access_?key|credential/i;
/** Credentials stay out of the log: the entry says the field changed, not what it held (also inside lines and objects). */
function redact(value, key = '') {
  if (value === null || value === undefined) return null;
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
const pair = (key, a, b) => [redact(a ?? null, key), redact(b ?? null, key)];

/**
 * One entry per created, changed or deleted record between `prev` and `next`: the action and, per field, the old and
 * new value (a deleted record keeps its last values). Records that did not change are skipped.
 * @returns {{ model: string, res_id: number, action: 'create'|'write'|'delete', changes: Record<string, [unknown, unknown]> }[]}
 */
export function auditEntries(prev, next) {
  const out = [];
  for (const model of new Set([...Object.keys(prev.records ?? {}), ...Object.keys(next.records ?? {})])) {
    const was = prev.records?.[model] ?? [];
    const now = next.records?.[model] ?? [];
    if (was === now) continue;
    const before = new Map(was.map((r) => [r.id, r]));
    const after = new Map(now.map((r) => [r.id, r]));
    for (const [id, rec] of after) {
      const old = before.get(id);
      if (old === rec) continue;
      const fields = [...new Set([...Object.keys(old ?? {}), ...Object.keys(rec)])].filter((k) => k !== 'id' && !same(old?.[k], rec[k]));
      if (!fields.length) continue;
      out.push({ model, res_id: id, action: old ? 'write' : 'create', changes: Object.fromEntries(fields.map((k) => [k, pair(k, old?.[k], rec[k])])) });
    }
    for (const [id, old] of before) {
      if (!after.has(id)) out.push({ model, res_id: id, action: 'delete', changes: Object.fromEntries(Object.keys(old).filter((k) => k !== 'id').map((k) => [k, pair(k, old[k], null)])) });
    }
  }
  out.push(...settingsEntries(prev.settings, next.settings), ...noteEntries(prev.messages, next.messages));
  return out;
}

/** One `settings` entry listing the settings keys that changed. */
function settingsEntries(was, now) {
  if (was === now || !now) return [];
  const keys = [...new Set([...Object.keys(was ?? {}), ...Object.keys(now)])].filter((k) => !same(was?.[k], now[k]));
  return keys.length ? [{ model: 'settings', res_id: 0, action: 'write', changes: Object.fromEntries(keys.map((k) => [k, pair(k, was?.[k], now[k])])) }] : [];
}

/** Chatter notes added, edited or removed (tracking messages only repeat the record changes and are not logged). */
function noteEntries(was = [], now = []) {
  if (was === now) return [];
  const notes = (list) => new Map(list.filter((m) => m.kind === 'note').map((m) => [m.id, m]));
  const before = notes(was);
  const after = notes(now);
  const entry = (m, action, a, b) => ({ model: 'mail.message', res_id: m.res_id, action, changes: { thread: [m.model, m.model], body: [a, b] } });
  return [
    ...[...after].filter(([id, m]) => !before.has(id) || before.get(id).body !== m.body).map(([id, m]) => entry(m, before.has(id) ? 'write' : 'create', before.get(id)?.body ?? null, m.body)),
    ...[...before].filter(([id]) => !after.has(id)).map(([, m]) => entry(m, 'delete', m.body, null)),
  ];
}

const shown = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v));
/** One line for an audit entry: "created", "deleted" or "field: old → new" per changed field. */
export function auditSummary(entry) {
  if (entry.action === 'create') return 'Created';
  if (entry.action === 'delete') return 'Deleted';
  return Object.entries(entry.changes ?? {}).map(([k, [a, b]]) => `${k}: ${shown(a)} → ${shown(b)}`).join(', ');
}
