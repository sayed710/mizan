// Detect model keys defined by more than one module in the models spread of src/models/index.js
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const idx = readFileSync(root + '/src/models/index.js', 'utf8');
const imports = new Map();
for (const m of idx.matchAll(/import \{([^}]+)\} from '\.\/([\w.-]+\.js)'/g)) for (const n of m[1].split(',').map((s) => s.trim())) imports.set(n, m[2]);
const line = idx.match(/export const models = withCompany\(\{([\s\S]*?)\}\);/)[1];
const order = [...line.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
console.log('spread entries:', order.length);
const { models } = await import(pathToFileURL(root + "/src/models/index.js"));
const owners = new Map();
const objs = {};
for (const name of order) {
  const mod = await import(pathToFileURL(root + '/src/models/' + imports.get(name)));
  objs[name] = mod[name];
  for (const k of Object.keys(mod[name])) { if (!owners.has(k)) owners.set(k, []); owners.get(k).push(name); }
}

console.log('total models in registry:', Object.keys(models).length);
const multi = [...owners].filter(([, o]) => o.length > 1);
console.log('model keys defined in >1 spread module:', multi.length);
let silent = 0;
for (const [k, o] of multi) {
  const winner = o.at(-1); const losers = o.slice(0, -1);
  const w = objs[winner][k];
  // does winner reuse loser's object pieces (extension) or replace them?
  const reuse = losers.map((l) => {
    const lo = objs[l][k];
    const shared = Object.keys(lo).filter((p) => w[p] === lo[p]);
    const fieldsExt = lo.fields && w.fields && Object.keys(lo.fields).every((f) => f in w.fields);
    const lostFields = lo.fields && w.fields ? Object.keys(lo.fields).filter((f) => !(f in w.fields)) : [];
    const lostButtons = (lo.form?.buttons ?? []).filter((b) => !(w.form?.buttons ?? []).some((x) => x.label === b.label || x.name === b.name)).map((b) => b.label ?? b.name);
    const sameGuard = lo.guard ? (w.guard === lo.guard ? 'kept' : (w.guard ? 'replaced' : 'DROPPED')) : '-';
    const samePD = lo.protectDelete ? (w.protectDelete === lo.protectDelete ? 'kept' : (w.protectDelete ? 'replaced' : 'DROPPED')) : '-';
    return `${l}: sharedProps=${shared.length} fieldsSuperset=${fieldsExt} lostFields=[${lostFields.join(',')}] lostButtons=[${lostButtons.join('|')}] guard=${sameGuard} protectDelete=${samePD}`;
  });
  console.log(`${k}  order=[${o.join(' > ')}] winner=${winner}\n    ` + reuse.join('\n    '));
}
