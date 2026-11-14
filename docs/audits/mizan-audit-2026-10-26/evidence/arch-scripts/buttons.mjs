// For every form button with run(), on every seed record where when(r) holds: run it in the "browser" ORM,
// then send the resulting diff through the server's applyDiff (admin) and count rejections.
globalThis.prompt = () => '1'; globalThis.confirm = () => true; globalThis.alert = () => {};
globalThis.window = { open() {}, location: {} }; globalThis.location = { hash: '', href: '' };
const { models } = await import(process.cwd() + '/src/models/index.js');
const { read, search } = await import(process.cwd() + '/src/orm.js');
const { applyDiff, diffDb } = await import(process.cwd() + '/src/sync.js');
const { seed } = await import(process.cwd() + '/src/seed.js');
const db = seed();
let tried = 0, browserThrew = 0, serverOk = 0, serverRejected = 0; const rej = new Map();
for (const [model, def] of Object.entries(models)) {
  for (const b of def.form?.buttons ?? []) {
    if (typeof b.run !== 'function' || b.server) continue;
    for (const r of (db.records[model] ?? []).slice(0, 6)) {
      let ok = true; try { ok = !b.when || b.when(r, db); } catch { ok = false; }
      if (!ok) continue;
      tried++;
      let res; try { res = b.run(db, read(db, model, r.id) ?? r); } catch { browserThrew++; continue; }
      if (!res?.db || res.db === db) continue;
      try { applyDiff(db, diffDb(db, res.db), { author: 'u', isAdmin: true }); serverOk++; }
      catch (e) { serverRejected++; const k = `${model} [${b.label}]: ${e.message.slice(0, 80)}`; rej.set(k, (rej.get(k) ?? 0) + 1); }
    }
  }
}
console.log({ tried, browserThrew, serverOk, serverRejected });
for (const [k, n] of [...rej].slice(0, 15)) console.log('  ', n, k);
