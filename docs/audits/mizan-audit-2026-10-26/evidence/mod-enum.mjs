// Read-only enumeration of Mizan model registry. Usage: node mod-enum.mjs <repo-copy> <outdir>
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2]; const out = process.argv[3];
const idx = await import(root + '/src/models/index.js');
const { models, apps, leavesOf, modelsForApps } = idx;

// 1. defining file(s) for every model key
const defFiles = {};
const mdir = root + '/src/models';
for (const f of fs.readdirSync(mdir).filter((f) => f.endsWith('.js') && f !== 'index.js')) {
  const mod = await import(mdir + '/' + f);
  for (const [ename, val] of Object.entries(mod)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) if (v && typeof v === 'object' && v.fields && v.label && models[k]) (defFiles[k] ??= new Set()).add(f);
    }
  }
}
// 2. per-model stats
const appsOf = {};
for (const a of apps) for (const l of leavesOf(a)) if (l.model) (appsOf[l.model] ??= new Set()).add(a.id);
const rows = {};
for (const [k, m] of Object.entries(models)) {
  const fields = Object.values(m.fields);
  const sub = fields.flatMap((f) => Object.values(f.fields ?? {}));
  const btns = m.form?.buttons ?? [];
  const rels = new Set([...fields, ...sub].map((f) => f.relation).filter(Boolean)); rels.delete(k);
  rows[k] = {
    model: k, file: [...(defFiles[k] ?? [])].join('+') || '?',
    fields: fields.length, subfields: sub.length,
    computes: [...fields, ...sub].filter((f) => f.compute).length,
    onchange: (m.onchange ? 1 : 0) + [...fields, ...sub].filter((f) => f.onchange).length,
    buttons: btns.length, runBtns: btns.filter((b) => typeof b.run === 'function').length,
    valsBtns: btns.filter((b) => b.vals && !b.run).length, serverBtns: btns.filter((b) => b.server).length,
    ruleButtons: typeof m.form?.ruleButtons === 'function',
    guard: typeof m.guard === 'function', protectDelete: typeof m.protectDelete === 'function', onUnlink: typeof m.onUnlink === 'function',
    lockedWhen: !!m.form?.lockedWhen, audited: typeof m.audited === 'function', statusbar: !!m.form?.statusbar,
    apps: [...(appsOf[k] ?? [])], rels: [...rels],
  };
}
// 3. per-app stats
const appRows = apps.map((a) => {
  const ms = [...new Set(leavesOf(a).filter((l) => l.model).map((l) => l.model))];
  const pages = leavesOf(a).filter((l) => l.type).map((l) => l.type);
  const r = ms.map((m) => rows[m]);
  const sum = (key) => r.reduce((t, x) => t + (typeof x[key] === 'boolean' ? (x[key] ? 1 : 0) : x[key]), 0);
  let allowed = null; try { allowed = modelsForApps([a.id]).size; } catch (e) { allowed = 'ERR ' + e.message; }
  return { id: a.id, name: a.name, models: ms, pages, nModels: ms.length, fields: sum('fields'), computes: sum('computes'), runBtns: sum('runBtns'), valsBtns: sum('valsBtns'), serverBtns: sum('serverBtns'), guards: sum('guard'), protectDelete: sum('protectDelete'), onchange: sum('onchange'), allowedModels: allowed,
    guardedModels: r.filter((x) => x.guard).map((x) => x.model) };
});
// models in no app menu
const orphan = Object.keys(models).filter((k) => !appsOf[k]);
fs.writeFileSync(out + '/models.json', JSON.stringify(rows, null, 1));
fs.writeFileSync(out + '/apps.json', JSON.stringify(appRows, null, 1));
console.log('models', Object.keys(models).length, 'apps', apps.length, 'guards', Object.values(rows).filter((r) => r.guard).length, 'protectDelete', Object.values(rows).filter((r) => r.protectDelete).length, 'onUnlink', Object.values(rows).filter((r) => r.onUnlink).length);
console.log('models w/o menu:', orphan.length, orphan.join(' '));
console.log('models with runBtns:', Object.values(rows).filter((r) => r.runBtns).length, ' computes:', Object.values(rows).filter((r) => r.computes).length, ' nothing (no compute/btn/onchange/guard):', Object.values(rows).filter((r) => !r.computes && !r.buttons && !r.onchange && !r.guard && !r.protectDelete && !r.ruleButtons).length);
console.log('unknown file:', Object.values(rows).filter((r) => r.file === '?').map((r) => r.model).join(' '));
