// Shared helpers for workflow scripts. Stubs browser globals used by button handlers.
export const prompts = [];
globalThis.prompt = (msg, def) => (prompts.length ? prompts.shift() : def);
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.window = { open() {} };
const { seed } = await import('../src/seed.js');
const { models } = await import('../src/models/index.js');
const orm = await import('../src/orm.js');
const { applyDiff, diffDb } = await import('../src/sync.js');
export { seed, models, orm, applyDiff, diffDb };
const { read, write, search } = orm;

/** Run a form button like the UI does (save, then run with the stored record). Reports whether `when` would show it. */
export function btn(db, model, id, label, { force = false } = {}) {
  const b = models[model].form.buttons.find((x) => x.label === label);
  if (!b) throw new Error(`no button ${label} on ${model}`);
  const r = read(db, model, id);
  const visible = !b.when || !!b.when(r);
  if (!visible && !force) return { db, visible, skipped: true };
  if (!b.run) return { db: write(db, model, id, b.vals), visible };
  const res = b.run(db, r);
  return { ...res, visible };
}
export const tryIt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: e.message }; } };

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b))) : x));
export { stable };
/** Send the client's change set through the server's applyDiff as a non-admin and report fields the server dropped. */
export function serverSync(base, next, opts = { isAdmin: false, author: 'user' }) {
  const d = diffDb(base, next);
  const server = applyDiff(base, JSON.parse(JSON.stringify(d)), opts);
  const lost = [];
  for (const [model, recs] of Object.entries(d.upserts)) {
    for (const r of recs) {
      const s = (server.records[model] ?? []).find((x) => x.id === r.id);
      if (!s) { lost.push(`${model}#${r.id}: whole record`); continue; }
      for (const [k, v] of Object.entries(r)) {
        if (models[model].fields[k]?.compute) continue;
        const a = stable(v ?? null); const b = stable(s[k] ?? null);
        if (a !== b) lost.push(`${model}#${r.id}.${k}: client=${a.slice(0, 80)} server=${b.slice(0, 80)}`);
      }
    }
  }
  return { db: server, lost, diff: d };
}

/** Balance (debit-credit) per account code over posted moves, optionally only lines touching a partner. */
export function ledger(db, { partner } = {}) {
  const acc = new Map((db.records['account.account'] ?? []).map((a) => [a.id, a.code]));
  const out = {};
  for (const m of db.records['account.move'] ?? []) {
    if (m.state !== 'posted') continue;
    for (const l of m.line_ids ?? []) {
      if (partner != null && l.partner_id !== partner) continue;
      const code = acc.get(l.account_id) ?? `?${l.account_id}`;
      out[code] = Math.round(((out[code] ?? 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0)) * 100) / 100;
    }
  }
  return out;
}
export const ledgerDelta = (a, b) => {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 100) / 100;
    if (d) out[k] = d;
  }
  return out;
};
export const newIds = (a, b, model) => (b.records[model] ?? []).filter((r) => !(a.records[model] ?? []).some((x) => x.id === r.id)).map((r) => r.id);
export const log = (...a) => console.log(...a);
