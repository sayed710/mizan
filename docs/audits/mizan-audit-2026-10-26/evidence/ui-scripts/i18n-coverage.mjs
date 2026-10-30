// Compare strings passed to t() (static literals + model-driven labels) with the Arabic dictionary in src/i18n.js.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.argv[2];
const src = fs.readFileSync(path.join(ROOT, 'src/i18n.js'), 'utf8');
const start = src.indexOf('const ar = {');
const end = src.indexOf('\n};', start);
const ar = new Function(`return ${src.slice(start + 'const ar = '.length, end + 2)}`)();
const arKeys = new Set(Object.keys(ar));
// duplicate keys in the literal (later wins silently)
const keyRe = /(?:^|[{,]\s*)(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*))\s*:/gm;
const body = src.slice(start, end);
const counts = new Map();
for (const m of body.matchAll(keyRe)) { const k = m[1] ?? m[2] ?? m[3]; counts.set(k, (counts.get(k) ?? 0) + 1); }
const dups = [...counts].filter(([, n]) => n > 1);

// 1. static t('literal') calls in non-test source
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(f) && !/\.test\.js$/.test(f)) files.push(p); } };
walk(path.join(ROOT, 'src'));
const tRe = /(?<![\w.$])t\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`)/g;
const staticKeys = new Map(); // key -> [file:line]
let dynamicCalls = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(tRe)) {
      const k = (m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'").replace(/\\"/g, '"');
      if (!staticKeys.has(k)) staticKeys.set(k, []);
      staticKeys.get(k).push(`${path.relative(ROOT, f)}:${i + 1}`);
    }
    const all = [...ln.matchAll(/(?<![\w.$])t\(/g)].length;
    const lit = [...ln.matchAll(tRe)].length;
    dynamicCalls += all - lit;
  });
}
// 2. model/menu driven labels that the UI passes through t()
const { models, apps } = await import(path.join(ROOT, 'src/models/index.js'));
const dyn = new Map();
const add = (k, where) => { if (typeof k === 'string' && k.trim() && /[A-Za-z]/.test(k)) { if (!dyn.has(k)) dyn.set(k, new Set()); dyn.get(k).add(where); } };
for (const a of apps) {
  add(a.name, 'app');
  for (const m of a.menus ?? []) { add(m.label, 'menu'); for (const c of m.children ?? []) add(c.label, 'menu'); }
}
for (const [name, def] of Object.entries(models)) {
  for (const f of Object.values(def.fields ?? {})) {
    add(f.label, 'field');
    for (const o of f.options ?? []) add(o[1], 'selection');
    for (const sf of Object.values(f.fields ?? {})) { add(sf.label, 'field'); for (const o of sf.options ?? []) add(o[1], 'selection'); }
  }
  const form = def.form ?? {};
  for (const b of form.buttons ?? []) add(b.label, 'button');
  if (Array.isArray(form.tabs)) for (const tb of form.tabs) add(tb.label, 'tab');
  for (const s of form.smart ?? []) add(s.label, 'smart');
}
const report = (map, label) => {
  const keys = [...map.keys()];
  const missing = keys.filter((k) => !arKeys.has(k));
  console.log(`${label}: ${keys.length} distinct, ${missing.length} without Arabic (${(100 * missing.length / keys.length).toFixed(1)}%)`);
  return missing;
};
console.log(`Arabic dictionary entries: ${arKeys.size}; duplicate keys in literal: ${dups.length}${dups.length ? ' e.g. ' + dups.slice(0, 5).map(([k]) => JSON.stringify(k)).join(', ') : ''}`);
console.log(`Source files scanned: ${files.length}; t() calls with a non-literal argument: ${dynamicCalls}`);
const missStatic = report(staticKeys, 'Static t() literals');
const missDyn = report(dyn, 'Model-driven labels (apps, menus, fields, selections, buttons, tabs, smart buttons)');
const union = new Set([...staticKeys.keys(), ...dyn.keys()]);
const missUnion = [...union].filter((k) => !arKeys.has(k));
console.log(`UNION of strings reaching t(): ${union.size} distinct, ${missUnion.length} untranslated (${(100 * missUnion.length / union.size).toFixed(1)}%)`);
const byKind = {};
for (const k of missDyn) for (const w of dyn.get(k)) byKind[w] = (byKind[w] ?? 0) + 1;
console.log('Untranslated model-driven labels by kind:', JSON.stringify(byKind));
const unused = [...arKeys].filter((k) => !union.has(k));
console.log(`Arabic entries never referenced by a static t() literal or model label: ${unused.length}`);
const sample = (arr, n) => arr.slice(0, n).map((k) => JSON.stringify(k)).join(', ');
console.log('Sample untranslated static:', missStatic.slice(0, 12).map((k) => `${JSON.stringify(k)} @${staticKeys.get(k)[0]}`).join(' | '));
console.log('Sample untranslated apps/menus:', sample(missDyn.filter((k) => dyn.get(k).has('app') || dyn.get(k).has('menu')), 25));
const appsMissing = apps.filter((a) => !arKeys.has(a.name)).map((a) => a.name);
console.log(`Apps (home tiles) without Arabic name: ${appsMissing.length}/${apps.length}:`, appsMissing.slice(0, 40).join(', '));
fs.writeFileSync(process.argv[3], JSON.stringify({ missStatic: missStatic.map((k) => [k, staticKeys.get(k)]), missDyn: missDyn.map((k) => [k, [...dyn.get(k)]]), unused }, null, 1));
