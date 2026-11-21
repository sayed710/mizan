// Exported functions in src/models/*.js referenced only by their own export line and tests.
import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const prod = [...walk(root + '/src'), ...walk(root + '/server')].filter((f) => /\.(js|jsx)$/.test(f) && !f.endsWith('.test.js'));
const srcs = Object.fromEntries(prod.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const tests = [...walk(root + '/src'), ...walk(root + '/server')].filter((f) => f.endsWith('.test.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const out = [];
for (const f of prod.filter((f) => f.includes('/src/models/'))) {
  const s = srcs[f];
  for (const m of s.matchAll(/^export (?:async )?function (\w+)|^export const (\w+) = (?:\([^)]*\)|\w+) =>/gm)) {
    const n = m[1] ?? m[2]; const re = new RegExp('\\b' + n + '\\b', 'g');
    const own = (s.match(re) ?? []).length - 1;
    const other = prod.filter((g) => g !== f && re.test(srcs[g])).length;
    if (own === 0 && other === 0) out.push(`${path.basename(f)}:${n}${new RegExp('\\b' + n + '\\b').test(tests) ? ' (tested)' : ''}`);
  }
}
console.log(out.length, 'exported model functions with no production caller:'); console.log(out.join('\n'));
