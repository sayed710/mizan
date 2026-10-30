import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('const ar = {'); const end = src.indexOf('\n};', start);
const body = src.slice(start + 12, end);
// crude: collect key: 'value' pairs in order, with line numbers
const re = /(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*))\s*:\s*'((?:\\.|[^'\\])*)'/g;
const seen = new Map(); const conflicts = [];
const lineOf = (i) => src.slice(0, start + 12 + i).split('\n').length;
for (const m of body.matchAll(re)) {
  const k = m[1] ?? m[2] ?? m[3]; const v = m[4];
  if (seen.has(k) && seen.get(k).v !== v) conflicts.push(`${JSON.stringify(k)}: L${seen.get(k).line} '${seen.get(k).v}' vs L${lineOf(m.index)} '${v}'`);
  seen.set(k, { v, line: lineOf(m.index) });
}
console.log(`conflicting duplicate keys: ${conflicts.length}`); console.log(conflicts.slice(0, 12).join('\n'));
