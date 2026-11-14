// Do business flows write keys that the server strips? Compare the client's records with what applyDiff stores.
const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read, search } = await import(W + '/src/orm.js');
const { models } = await import(W + '/src/models/index.js');
const { postMove, payMove } = await import(W + '/src/models/accounting.js');
const s0 = seed();
const lost = new Map();
const check = (label, base, next) => {
  const d = diffDb(base, next);
  const srv = applyDiff(base, d);
  for (const [m, recs] of Object.entries(d.upserts)) for (const r of recs) {
    const sr = srv.records[m].find((x) => x.id === r.id);
    const computed = new Set(Object.entries(models[m].fields).filter(([, f]) => f.compute).map(([k]) => k));
    for (const k of Object.keys(r)) if (!computed.has(k) && !(k in sr) && r[k] !== undefined) { const key = `${m}.${k}`; lost.set(key, (lost.get(key) ?? 0) + 1); }
    for (const [k, f] of Object.entries(models[m].fields)) if (f.type === 'one2many' && Array.isArray(r[k])) r[k].forEach((l, i) => { for (const lk of Object.keys(l)) if (!(lk in (sr[k]?.[i] ?? {})) && l[lk] !== undefined) { const key = `${m}.${k}[].${lk}`; lost.set(key, (lost.get(key) ?? 0) + 1); } });
  }
  return srv;
};
// Run every visible form button of every seeded record once (non-interactive), collecting dropped keys
globalThis.prompt = () => '1'; globalThis.confirm = () => true; globalThis.alert = () => {};
let runs = 0, errors = 0;
for (const [m, def] of Object.entries(models)) for (const r of (s0.records[m] ?? [])) for (const b of def.form?.buttons ?? []) {
  if (!b.run || (b.when && !b.when(read(s0, m, r.id)))) continue;
  try { const out = b.run(s0, read(s0, m, r.id)); if (out?.db && out.db !== s0) { check(`${m}:${b.label}`, s0, out.db); runs++; } } catch { errors++; }
}
console.log('button runs', runs, 'threw', errors);
console.log('keys written by business logic but stripped by the server:', [...lost].map(([k, n]) => `${k}(${n})`).join(', ') || 'none');
