// Server-side change log: what changed between two database versions, record by record.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
      out.push({ model, res_id: id, action: old ? 'write' : 'create', changes: Object.fromEntries(fields.map((k) => [k, [old?.[k] ?? null, rec[k] ?? null]])) });
    }
    for (const [id, old] of before) {
      if (!after.has(id)) out.push({ model, res_id: id, action: 'delete', changes: Object.fromEntries(Object.keys(old).filter((k) => k !== 'id').map((k) => [k, [old[k], null]])) });
    }
  }
  return out;
}
