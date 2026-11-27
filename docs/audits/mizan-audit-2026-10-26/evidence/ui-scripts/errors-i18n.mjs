// Error/validation messages thrown by models or returned by guards are shown raw (FormView.jsx:361, store.js:114 alert).
import fs from 'node:fs'; import path from 'node:path';
const ROOT = process.argv[2];
const src = fs.readFileSync(path.join(ROOT, 'src/i18n.js'), 'utf8');
const s = src.indexOf('const ar = {'); const e = src.indexOf('\n};', s);
const ar = new Function(`return ${src.slice(s + 11, e + 2)}`)();
const msgs = new Set();
const dir = path.join(ROOT, 'src/models');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of text.matchAll(/throw new Error\('((?:\\.|[^'\\])*)'\)|return '((?:\\.|[^'\\])+)';/g)) msgs.add(m[1] ?? m[2]);
}
for (const f of ['src/orm.js', 'src/validate.js', 'src/sync.js']) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/throw new Error\('((?:\\.|[^'\\])*)'\)/g)) msgs.add(m[1]);
}
const list = [...msgs].filter((m) => /[A-Za-z]{3}/.test(m) && m.includes(' '));
const inDict = list.filter((m) => ar[m]);
console.log(`literal error/guard messages: ${list.length}; with an Arabic entry: ${inDict.length}; template-literal (dynamic) errors not counted`);
console.log('examples with Arabic entry but displayed raw:', inDict.slice(0, 4).map((m) => JSON.stringify(m)).join(', '));
