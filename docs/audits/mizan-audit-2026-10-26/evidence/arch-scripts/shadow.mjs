import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const idx = readFileSync(root + '/src/models/index.js', 'utf8');
const imports = new Map();
for (const m of idx.matchAll(/import \{([^}]+)\} from '\.\/([\w.-]+\.js)'/g)) for (const n of m[1].split(',').map((s) => s.trim())) imports.set(n, m[2]);
const order = [...idx.match(/export const models = withCompany\(\{([\s\S]*?)\}\);/)[1].matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);
await import(pathToFileURL(root + '/src/models/index.js'));
const objs = {}; const owners = new Map();
for (const name of order) { const mod = await import(pathToFileURL(root + '/src/models/' + imports.get(name))); objs[name] = mod[name]; for (const k of Object.keys(mod[name])) { if (!owners.has(k)) owners.set(k, []); owners.get(k).push(name); } }
let extend = 0, replace = 0; const rep = [];
for (const [k, o] of owners) { if (o.length < 2) continue; const w = objs[o.at(-1)][k];
  for (const l of o.slice(0, -1)) { const lo = objs[l][k];
    const objShared = Object.keys(lo).filter((p) => typeof lo[p] === 'object' || typeof lo[p] === 'function').filter((p) => w[p] === lo[p] || (w[p] && typeof w[p]==='object' && lo[p] && Object.keys(lo[p]).some((q) => w[p][q] === lo[p][q] && typeof lo[p][q] === 'object')));
    if (objShared.length) extend++; else { replace++; rep.push(`${k}: ${imports.get(l)} (shadowed) -> ${imports.get(o.at(-1))}`); }
  } }
console.log('base definitions extended by a later module:', extend, '; base definitions fully replaced (dead code):', replace);
console.log(rep.join('\n'));
